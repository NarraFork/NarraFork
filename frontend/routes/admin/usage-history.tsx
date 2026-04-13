import { UsageHistoryTable } from "@frontend/components/usage-history/UsageHistoryTable";
import { UsageStatsCards } from "@frontend/components/usage-history/UsageStatsCards";
import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import type { UsageHistoryFilters } from "@frontend/types/usage-history";
import { Button, Group, Pagination, Select, Stack, TextInput, Title } from "@mantine/core";
import { IconFilter, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/admin/usage-history")({
	component: UsageHistoryPage,
});

function UsageHistoryPage() {
	const { t } = useTranslation("common");
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

	const applyFilters = () => {
		setFilters({
			...tempFilters,
			startDate: startDate ? new Date(startDate).toISOString() : undefined,
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
		<div style={{ padding: "2rem", maxWidth: 1400, margin: "0 auto" }}>
			<Stack gap="xl">
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

				{stats ? <UsageStatsCards stats={stats} /> : null}

				<Stack gap="md">
					<Group align="end">
						<Select
							label={t("usageHistoryProvider")}
							placeholder={t("usageHistoryAllProviders")}
							clearable
							data={[
								{ value: "anthropic", label: "Anthropic" },
								{ value: "openai", label: "OpenAI" },
								{ value: "codex", label: "Codex" },
							]}
							value={tempFilters.provider ?? null}
							onChange={(value) =>
								setTempFilters((prev) => ({ ...prev, provider: value || undefined }))
							}
						/>
						<TextInput
							label={t("usageHistoryModel")}
							placeholder={t("usageHistoryModelPlaceholder")}
							value={tempFilters.model ?? ""}
							onChange={(e) =>
								setTempFilters((prev) => ({ ...prev, model: e.currentTarget.value || undefined }))
							}
						/>
						<input
							type="date"
							value={startDate}
							onChange={(e) => setStartDate(e.currentTarget.value)}
							style={{
								padding: 8,
								borderRadius: 8,
								border: "1px solid var(--mantine-color-default-border)",
							}}
						/>
						<input
							type="date"
							value={endDate}
							onChange={(e) => setEndDate(e.currentTarget.value)}
							style={{
								padding: 8,
								borderRadius: 8,
								border: "1px solid var(--mantine-color-default-border)",
							}}
						/>
						<Button leftSection={<IconFilter size={16} />} onClick={applyFilters}>
							{t("usageHistoryApplyFilters")}
						</Button>
						<Button variant="light" onClick={resetFilters}>
							{t("usageHistoryReset")}
						</Button>
					</Group>
				</Stack>

				<UsageHistoryTable records={listData?.records ?? []} loading={isLoadingList} />

				{listData && listData.totalPages > 1 ? (
					<Group justify="center">
						<Pagination value={page} onChange={setPage} total={listData.totalPages} />
					</Group>
				) : null}
			</Stack>
		</div>
	);
}
