import { formatReferenceCost } from "@frontend/lib/usage-cost";
import { usageHistoryApi } from "@frontend/lib/usage-history-api";
import {
	advanceUsageHistoryCursor,
	currentUsageHistoryCursor,
	retreatUsageHistoryCursor,
} from "@frontend/lib/usage-history-cursor-window";
import { usageUserLabel } from "@frontend/lib/usage-history-user";
import { Alert, Button, Card, Group, Stack, Table, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

const USER_TOTALS_PAGE_SIZE = 50;

/** Separate durable ledger: never accepts request-history filters. */
export function UserUsageTotalsSection() {
	const { t } = useTranslation("common");
	const [cursorStack, setCursorStack] = useState<string[]>([]);
	const cursor = currentUsageHistoryCursor(cursorStack);
	const { data, isLoading, isFetching, isError, refetch } = useQuery({
		queryKey: ["usage-history", "user-totals", USER_TOTALS_PAGE_SIZE, cursor ?? null],
		queryFn: ({ signal }) =>
			usageHistoryApi.getUserTotals({ cursor, limit: USER_TOTALS_PAGE_SIZE, signal }),
		gcTime: 60_000,
	});

	return (
		<Card withBorder>
			<Stack gap="sm">
				<Group justify="space-between">
					<Title order={3}>{t("usageUserTotalsTitle")}</Title>
					<Button size="xs" variant="light" loading={isFetching} onClick={() => refetch()}>
						{t("usageHistoryRefresh")}
					</Button>
				</Group>
				<Text size="sm" c="dimmed">
					{t("usageUserTotalsDescription")}
				</Text>
				<Text size="xs" c="dimmed">
					{t("usageUserTotalsCostNote")}
				</Text>
				{isError ? (
					<Alert color="red">{t("usageUserTotalsLoadFailed")}</Alert>
				) : isLoading ? (
					<Text c="dimmed">{t("usageHistoryTableLoading")}</Text>
				) : !data?.records.length ? (
					<Text c="dimmed">{t("usageUserTotalsEmpty")}</Text>
				) : (
					<Table.ScrollContainer minWidth={1050}>
						<Table striped withTableBorder>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>{t("usageHistoryUser")}</Table.Th>
									<Table.Th>{t("usageHistoryStatRequests")}</Table.Th>
									<Table.Th>{t("usageHistoryMetricInputTokens")}</Table.Th>
									<Table.Th>{t("usageHistoryMetricOutputTokens")}</Table.Th>
									<Table.Th>{t("usageHistoryStatCacheRead")}</Table.Th>
									<Table.Th>{t("usageHistoryStatCacheWrite")}</Table.Th>
									<Table.Th>{t("usageHistoryMetricReasoningTokens")}</Table.Th>
									<Table.Th>{t("usageUserTotalsCost")}</Table.Th>
									<Table.Th>{t("usageUserTotalsUnpriced")}</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{data.records.map((record) => (
									<Table.Tr key={record.userId}>
										<Table.Td>
											<Text size="sm">{usageUserLabel(record, t("usageHistoryUnattributed"))}</Text>
											{record.username ? (
												<Text size="xs" c="dimmed">
													{record.userId}
												</Text>
											) : null}
										</Table.Td>
										<Table.Td>{record.requestCount}</Table.Td>
										<Table.Td>{record.inputTokens}</Table.Td>
										<Table.Td>{record.outputTokens}</Table.Td>
										<Table.Td>{record.cachedInputTokens}</Table.Td>
										<Table.Td>{record.cacheCreationTokens}</Table.Td>
										<Table.Td>{record.reasoningTokens}</Table.Td>
										<Table.Td>
											{formatReferenceCost(record, record.costUsd, {
												unknown: t("usageCostUnknown"),
												partial: t("usageCostPartial"),
											})}
										</Table.Td>
										<Table.Td>{record.unpricedRequestCount}</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					</Table.ScrollContainer>
				)}
				<Group justify="center">
					<Button
						size="xs"
						variant="light"
						disabled={!cursorStack.length || isFetching}
						onClick={() => setCursorStack(retreatUsageHistoryCursor)}
					>
						{t("usageHistoryPreviousPage")}
					</Button>
					<Text size="sm">{t("usageHistoryPage", { page: cursorStack.length + 1 })}</Text>
					<Button
						size="xs"
						variant="light"
						disabled={isError || !data?.hasMore || !data.nextCursor || isFetching}
						onClick={() =>
							setCursorStack((current) => advanceUsageHistoryCursor(current, data?.nextCursor))
						}
					>
						{t("usageHistoryNextPage")}
					</Button>
				</Group>
			</Stack>
		</Card>
	);
}
