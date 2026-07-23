import { UsageHistoryChart } from "@frontend/components/usage-history/UsageHistoryChart";
import { UsageHistoryTable } from "@frontend/components/usage-history/UsageHistoryTable";
import { UsageStatsCards } from "@frontend/components/usage-history/UsageStatsCards";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import {
	advanceUsageHistoryCursor,
	currentUsageHistoryCursor,
	retreatUsageHistoryCursor,
	usageHistoryListQueryKey,
} from "@frontend/lib/usage-history-cursor-window";
import type { UsageHistoryFilters, UsageHistoryGranularity } from "@frontend/types/usage-history";
import {
	Autocomplete,
	Button,
	Group,
	Select,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconFilter, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/settings/usage")({
	component: SettingsUsagePage,
});

const USAGE_HISTORY_QUERY_GC_TIME_MS = 60_000;

function SettingsUsagePage() {
	const { t } = useTranslation("common");
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const [pageSize, setPageSize] = useState(50);
	const [cursorStack, setCursorStack] = useState<string[]>([]);
	const [filters, setFilters] = useState<UsageHistoryFilters>({});
	const [tempFilters, setTempFilters] = useState<UsageHistoryFilters>({});
	const [granularity, setGranularity] = useState<UsageHistoryGranularity>("day");
	const [startDate, setStartDate] = useState("");
	const [endDate, setEndDate] = useState("");
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

	const kindOptions = [
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
	].map((kind) => ({ value: kind, label: t(`usageHistoryKind_${kind}`, kind) }));

	const applyFilters = () => {
		setCursorStack([]);
		setFilters({
			provider: tempFilters.provider?.trim() || undefined,
			model: tempFilters.model?.trim() || undefined,
			kind: tempFilters.kind || undefined,
			startDate: startDate ? new Date(`${startDate}T00:00:00.000Z`).toISOString() : undefined,
			endDate: endDate ? new Date(`${endDate}T23:59:59.999Z`).toISOString() : undefined,
		});
	};

	const resetFilters = () => {
		setTempFilters({});
		setStartDate("");
		setEndDate("");
		setCursorStack([]);
		setFilters({});
	};

	return (
		<div
			style={{
				padding: isMobile ? "0.75rem" : "2rem",
				maxWidth: 1400,
				margin: "0 auto",
			}}
		>
			<Stack gap={isMobile ? "md" : "xl"}>
				{isMobile ? (
					<Stack gap="xs">
						<Title order={3}>{t("usageHistoryTitle")}</Title>
						<Button
							size="sm"
							leftSection={<IconRefresh size={14} />}
							variant="light"
							fullWidth
							onClick={() => {
								refetchList();
								refetchStats();
								refetchTimeSeries();
							}}
						>
							{t("usageHistoryRefresh")}
						</Button>
					</Stack>
				) : (
					<Group justify="space-between">
						<Title order={2}>{t("usageHistoryTitle")}</Title>
						<Button
							leftSection={<IconRefresh size={16} />}
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
				)}

				{stats ? <UsageStatsCards stats={stats} /> : null}

				<UsageHistoryChart
					data={timeSeries}
					loading={isLoadingTimeSeries}
					granularity={granularity}
					onGranularityChange={setGranularity}
				/>

				<Stack gap={isMobile ? "xs" : "md"}>
					<SimpleGrid
						cols={{ base: 1, sm: 2, lg: 5 }}
						spacing={isMobile ? "xs" : "md"}
						verticalSpacing={isMobile ? "xs" : "md"}
					>
						<Autocomplete
							size={isMobile ? "xs" : "sm"}
							label={t("usageHistoryProvider")}
							placeholder={t("usageHistoryProviderPlaceholder")}
							data={providersData?.providers ?? []}
							value={tempFilters.provider ?? ""}
							onChange={(value) =>
								setTempFilters((prev) => ({
									...prev,
									provider: value || undefined,
								}))
							}
						/>
						<TextInput
							size={isMobile ? "xs" : "sm"}
							label={t("usageHistoryModel")}
							placeholder={t("usageHistoryModelPlaceholder")}
							value={tempFilters.model ?? ""}
							onChange={(e) => {
								const value = e.currentTarget.value;
								setTempFilters((prev) => ({ ...prev, model: value || undefined }));
							}}
						/>
						<Select
							size={isMobile ? "xs" : "sm"}
							label={t("usageHistoryKind")}
							placeholder={t("usageHistoryAllKinds")}
							data={kindOptions}
							clearable
							value={tempFilters.kind ?? null}
							onChange={(value) =>
								setTempFilters((prev) => ({ ...prev, kind: value || undefined }))
							}
						/>
						<TextInput
							size={isMobile ? "xs" : "sm"}
							label={t("usageHistoryStartDate")}
							type="date"
							value={startDate}
							onChange={(e) => setStartDate(e.currentTarget.value)}
						/>
						<TextInput
							size={isMobile ? "xs" : "sm"}
							label={t("usageHistoryEndDate")}
							type="date"
							value={endDate}
							onChange={(e) => setEndDate(e.currentTarget.value)}
						/>
					</SimpleGrid>

					<Group grow={isMobile} wrap="wrap" gap={isMobile ? "xs" : "sm"}>
						<Button
							size={isMobile ? "xs" : "sm"}
							leftSection={<IconFilter size={isMobile ? 14 : 16} />}
							onClick={applyFilters}
						>
							{t("usageHistoryApplyFilters")}
						</Button>
						<Button size={isMobile ? "xs" : "sm"} variant="light" onClick={resetFilters}>
							{t("usageHistoryReset")}
						</Button>
					</Group>
				</Stack>

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
							setCursorStack((current) => advanceUsageHistoryCursor(current, listData?.nextCursor));
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
		</div>
	);
}
