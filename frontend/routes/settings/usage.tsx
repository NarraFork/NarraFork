import { UsageHistoryTable } from "@frontend/components/usage-history/UsageHistoryTable";
import { UsageStatsCards } from "@frontend/components/usage-history/UsageStatsCards";
import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import type { UsageHistoryFilters } from "@frontend/types/usage-history";
import {
	Autocomplete,
	Button,
	Group,
	Pagination,
	Select,
	SimpleGrid,
	Stack,
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

function SettingsUsagePage() {
	const { t } = useTranslation("common");
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;
	const [page, setPage] = useState(1);
	const pageSize = 50;
	const [filters, setFilters] = useState<UsageHistoryFilters>({});
	const [tempFilters, setTempFilters] = useState<UsageHistoryFilters>({});
	const [startDate, setStartDate] = useState("");
	const [endDate, setEndDate] = useState("");

	const {
		data: listData,
		isLoading: isLoadingList,
		refetch: refetchList,
	} = useQuery({
		queryKey: ["usage-history", "list", filters, page, pageSize],
		queryFn: () => usageHistoryApi.list({ ...filters, page, pageSize }),
	});

	const { data: stats, refetch: refetchStats } = useQuery({
		queryKey: ["usage-history", "stats", filters],
		queryFn: () => usageHistoryApi.getStats(filters),
	});

	const { data: providersData } = useQuery({
		queryKey: ["usage-history", "providers"],
		queryFn: () => usageHistoryApi.listProviders(),
	});

	const kindOptions = [
		"narrator",
		"compact",
		"fork_summary",
		"title",
		"merge_summary",
		"web_fetch_smart",
		"reasoning_translation",
		"settings_test",
		"git_summary",
		"internal",
	].map((kind) => ({ value: kind, label: t(`usageHistoryKind_${kind}`, kind) }));

	const applyFilters = () => {
		setFilters({
			provider: tempFilters.provider?.trim() || undefined,
			model: tempFilters.model?.trim() || undefined,
			kind: tempFilters.kind || undefined,
			startDate: startDate ? new Date(`${startDate}T00:00:00.000Z`).toISOString() : undefined,
			endDate: endDate ? new Date(`${endDate}T23:59:59.999Z`).toISOString() : undefined,
		});
		setPage(1);
	};

	const resetFilters = () => {
		setTempFilters({});
		setStartDate("");
		setEndDate("");
		setFilters({});
		setPage(1);
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
							}}
						>
							{t("usageHistoryRefresh")}
						</Button>
					</Group>
				)}

				{stats ? <UsageStatsCards stats={stats} /> : null}

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
							onChange={(e) =>
								setTempFilters((prev) => ({ ...prev, model: e.currentTarget.value || undefined }))
							}
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

				{listData && listData.totalPages > 1 ? (
					<Group justify="center">
						<Pagination
							value={page}
							onChange={setPage}
							total={listData.totalPages}
							siblings={isMobile ? 0 : 1}
							boundaries={isMobile ? 0 : 1}
							size={isMobile ? "sm" : "md"}
						/>
					</Group>
				) : null}
			</Stack>
		</div>
	);
}
